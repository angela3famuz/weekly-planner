/*
 * Needs a real Postgres. Locally:
 *   createdb planner_sync_test
 *   DATABASE_URL=postgresql://postgres:postgres@localhost:5432/planner_sync_test npm test
 *
 * Skips rather than fails when DATABASE_URL is unset, so `npm test` is safe to
 * run anywhere.
 */
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const HAS_DB = Boolean(process.env.DATABASE_URL);
const PASSPHRASE = 'correct-horse-battery-staple';

let pool, createApp, passphraseHash, server, base;

const ORIGIN = 'https://angela3famuz.github.io';

before(async (t) => {
  if (!HAS_DB) return t.skip('DATABASE_URL not set');
  const auth = await import('../auth.js');
  passphraseHash = await auth.hashPassphrase(PASSPHRASE);

  const dbMod = await import('../db.js');
  pool = dbMod.pool;
  await dbMod.migrate();

  ({ createApp } = await import('../index.js'));
  // Raise the auth and sync limits for the bulk of the suite; a dedicated test
  // below spins up its own app to check the real limiter actually bites. The
  // concurrency test alone spends more than the real 60/min sync budget, and a
  // 429 there would look exactly like the data loss it is hunting for.
  const app = createApp({
    passphraseHash, allowedOrigins: [ORIGIN],
    authLimit: 1000, authGlobalLimit: 1000, syncLimit: 100000,
  });
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) await new Promise((r) => server.close(r));
  if (pool) await pool.end();
});

beforeEach(async () => {
  if (!HAS_DB) return;
  await pool.query('truncate weeks, settings, tokens, history');
  await pool.query('alter sequence sync_seq restart with 1');
});

const post = (path, body, token) =>
  fetch(base + path, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });

async function login() {
  const r = await post('/auth', { passphrase: PASSPHRASE });
  assert.equal(r.status, 200);
  return (await r.json()).token;
}

const week = (updatedAt, focus) => ({ focus, blocks: [], updatedAt });

test('health proves the database is reachable, not just that we are alive', { skip: !HAS_DB }, async () => {
  const r = await fetch(base + '/health');
  const body = await r.json();
  assert.equal(r.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.configured, true);
  assert.equal(body.passphrase, 'ok');
  assert.equal(body.database, 'connected');
  assert.ok(body.version, 'version answers "is my fix deployed?" without reading logs');
});

test('health turns 503 when the database is broken, and leaks nothing', { skip: !HAS_DB }, async () => {
  // The old check never touched the database, so it reported ok:true while the
  // service was useless. Break what it reads and prove it now notices.
  await pool.query('alter table weeks rename to weeks_hidden');
  try {
    const r = await fetch(base + '/health');
    const body = await r.json();
    assert.equal(r.status, 503);
    assert.equal(body.ok, false);
    assert.equal(body.database, 'unreachable');
    // The detail names the host and the schema — it belongs in the logs, not
    // in a reply to whoever curls this.
    assert.ok(!JSON.stringify(body).includes('weeks'), 'must not leak schema details');
    assert.ok(!JSON.stringify(body).includes('relation'), 'must not leak the driver error');
  } finally {
    await pool.query('alter table weeks_hidden rename to weeks');
  }
});

/* ---------------- the stored hash -----------------------------------------
   Every way a pasted env var gets damaged used to produce the same 401 as a
   genuinely wrong passphrase, so a correct passphrase looked like a typo.   */

test('a damaged stored hash is recognised, not silently refused', { skip: !HAS_DB }, async () => {
  const { hashState, normalizeStoredHash } = await import('../kdf.js');

  // Damage that has exactly one intended meaning is repaired, not punished.
  assert.equal(hashState(passphraseHash), 'ok');
  assert.equal(hashState('  ' + passphraseHash + '  '), 'ok', 'stray whitespace');
  assert.equal(hashState('"' + passphraseHash + '"'), 'ok', 'wrapped in quotes');
  assert.equal(hashState("'" + passphraseHash + "'"), 'ok', 'single quotes');
  assert.equal(hashState('PASSPHRASE_HASH=' + passphraseHash), 'ok', 'the whole line pasted');

  // Damage that cannot be repaired is named.
  assert.equal(hashState(''), 'missing');
  assert.equal(hashState(undefined), 'missing');
  assert.equal(hashState('scrypt'), 'malformed', 'truncated');
  assert.equal(hashState('scrypt$$$$abc$def'), 'malformed', '$-parts eaten by shell expansion');
  assert.equal(hashState('bcrypt$1$2$3$a$b'), 'malformed', 'not our format');
  assert.equal(normalizeStoredHash('PASSPHRASE_HASH=' + passphraseHash), passphraseHash);
});

test('a repaired hash still accepts the correct passphrase end to end', { skip: !HAS_DB }, async () => {
  const app = createApp({
    passphraseHash: 'PASSPHRASE_HASH="' + passphraseHash + '"',   // both mistakes at once
    allowedOrigins: [ORIGIN], authLimit: 50,
  });
  const s = app.listen(0);
  await new Promise((r) => s.once('listening', r));
  try {
    const r = await fetch(`http://127.0.0.1:${s.address().port}/auth`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ passphrase: PASSPHRASE }),
    });
    assert.equal(r.status, 200, 'a recoverable paste mistake must not cost anyone an afternoon');
  } finally { await new Promise((r) => s.close(r)); }
});

test('an unusable hash returns 503, not 401 — it is the server at fault', { skip: !HAS_DB }, async () => {
  const app = createApp({ passphraseHash: 'scrypt$$$$abc$def', allowedOrigins: [ORIGIN], authLimit: 50 });
  const s = app.listen(0);
  await new Promise((r) => s.once('listening', r));
  try {
    const port = s.address().port;
    const r = await fetch(`http://127.0.0.1:${port}/auth`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ passphrase: PASSPHRASE }),
    });
    assert.equal(r.status, 503, 'a broken hash is not a wrong passphrase');
    assert.equal((await r.json()).error, 'passphrase_hash_malformed');

    const h = await (await fetch(`http://127.0.0.1:${port}/health`)).json();
    assert.equal(h.passphrase, 'malformed', 'health must say which');
    assert.equal(h.configured, false, 'configured must not claim ok for an unusable hash');
  } finally { await new Promise((r) => s.close(r)); }
});

test('wrong passphrase is rejected and issues no token', { skip: !HAS_DB }, async () => {
  const r = await post('/auth', { passphrase: 'nope' });
  assert.equal(r.status, 401);
  assert.equal((await r.json()).error, 'wrong_passphrase');
  const { rows } = await pool.query('select count(*)::int as n from tokens');
  assert.equal(rows[0].n, 0);
});

test('sync without a token is refused', { skip: !HAS_DB }, async () => {
  assert.equal((await post('/sync', { since: 0 })).status, 401);
});

test('a revoked token stops working', { skip: !HAS_DB }, async () => {
  const token = await login();
  assert.equal((await post('/sync', { since: 0 }, token)).status, 200);
  const del = await fetch(base + '/tokens', { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } });
  assert.equal(del.status, 200);
  assert.equal((await post('/sync', { since: 0 }, token)).status, 401);
});

test('push then pull from a second device', { skip: !HAS_DB }, async () => {
  const phone = await login();
  const up = await (await post('/sync', {
    since: 0,
    weeks: { '2026-07-13': week(1000, 'from phone') },
  }, phone)).json();
  assert.deepEqual(up.conflicts, []);
  assert.ok(up.now > 0);

  // Fresh device: cursor 0, so it pulls everything.
  const laptop = await login();
  const down = await (await post('/sync', { since: 0 }, laptop)).json();
  assert.equal(down.weeks['2026-07-13'].focus, 'from phone');
});

test('the cursor only returns what is new', { skip: !HAS_DB }, async () => {
  const token = await login();
  const first = await (await post('/sync', {
    since: 0, weeks: { '2026-07-13': week(1000, 'a') },
  }, token)).json();

  // Nothing changed since: no weeks come back.
  const second = await (await post('/sync', { since: first.now }, token)).json();
  assert.deepEqual(second.weeks, {});
  assert.equal(second.now, first.now);

  // Another device writes; now the cursor picks it up.
  const other = await login();
  await post('/sync', { since: 0, weeks: { '2026-07-20': week(2000, 'b') } }, other);
  const third = await (await post('/sync', { since: first.now }, token)).json();
  assert.deepEqual(Object.keys(third.weeks), ['2026-07-20']);
});

test('older write loses and is reported as a conflict', { skip: !HAS_DB }, async () => {
  const token = await login();
  await post('/sync', { since: 0, weeks: { '2026-07-13': week(5000, 'newer') } }, token);

  const stale = await (await post('/sync', {
    since: 0, weeks: { '2026-07-13': week(4000, 'older') },
  }, token)).json();

  assert.deepEqual(stale.conflicts, ['2026-07-13']);
  // The server's copy is returned so the loser can correct itself.
  assert.equal(stale.weeks['2026-07-13'].focus, 'newer');
});

test('equal timestamps do not overwrite', { skip: !HAS_DB }, async () => {
  const token = await login();
  await post('/sync', { since: 0, weeks: { '2026-07-13': week(5000, 'first') } }, token);
  const tie = await (await post('/sync', {
    since: 0, weeks: { '2026-07-13': week(5000, 'second') },
  }, token)).json();
  assert.deepEqual(tie.conflicts, ['2026-07-13']);
  assert.equal(tie.weeks['2026-07-13'].focus, 'first');
});

test('newer write wins', { skip: !HAS_DB }, async () => {
  const token = await login();
  await post('/sync', { since: 0, weeks: { '2026-07-13': week(1000, 'old') } }, token);
  const r = await (await post('/sync', {
    since: 0, weeks: { '2026-07-13': week(9000, 'new') },
  }, token)).json();
  assert.deepEqual(r.conflicts, []);
  assert.equal(r.weeks['2026-07-13'].focus, 'new');
});

test('a clock 10 minutes fast is rejected, not clamped', { skip: !HAS_DB }, async () => {
  const token = await login();
  const future = Date.now() + 10 * 60 * 1000;
  const r = await post('/sync', { since: 0, weeks: { '2026-07-13': week(future, 'fast') } }, token);
  assert.equal(r.status, 400);
  assert.equal((await r.json()).error, 'clock_skew');
  // and nothing was written
  const { rows } = await pool.query('select count(*)::int as n from weeks');
  assert.equal(rows[0].n, 0);
});

test('a bad week in the batch writes none of it', { skip: !HAS_DB }, async () => {
  const token = await login();
  const r = await post('/sync', {
    since: 0,
    weeks: { '2026-07-13': week(1000, 'fine'), 'nonsense': week(1000, 'bad') },
  }, token);
  assert.equal(r.status, 400);
  assert.equal((await r.json()).error, 'bad_week_key');
  const { rows } = await pool.query('select count(*)::int as n from weeks');
  assert.equal(rows[0].n, 0, 'the valid week must not have been written either');
});

test('tombstones survive and propagate', { skip: !HAS_DB }, async () => {
  const token = await login();
  await post('/sync', { since: 0, weeks: { '2026-07-13': week(1000, 'here') } }, token);
  await post('/sync', {
    since: 0, weeks: { '2026-07-13': { ...week(2000, 'here'), deleted: true } },
  }, token);

  const fresh = await login();
  const down = await (await post('/sync', { since: 0 }, fresh)).json();
  assert.equal(down.weeks['2026-07-13'].deleted, true);
});

test('settings sync and follow the same LWW rule', { skip: !HAS_DB }, async () => {
  const token = await login();
  await post('/sync', { since: 0, settings: { habits: ['Water'], updatedAt: 2000 } }, token);
  const stale = await (await post('/sync', {
    since: 0, settings: { habits: ['Nope'], updatedAt: 1000 },
  }, token)).json();
  assert.ok(stale.conflicts.includes('settings'));
  assert.deepEqual(stale.settings.habits, ['Water']);
});

test('week dates round-trip without timezone drift', { skip: !HAS_DB }, async () => {
  const token = await login();
  const keys = ['2026-01-01', '2026-06-29', '2026-12-28'];
  const weeks = {};
  keys.forEach((k, i) => { weeks[k] = week(1000 + i, k); });
  await post('/sync', { since: 0, weeks }, token);
  const down = await (await post('/sync', { since: 0 }, await login())).json();
  assert.deepEqual(Object.keys(down.weeks).sort(), keys);
});

test('CORS allows the planner origin and no other', { skip: !HAS_DB }, async () => {
  const ok = await fetch(base + '/sync', {
    method: 'OPTIONS', headers: { Origin: ORIGIN },
  });
  assert.equal(ok.headers.get('access-control-allow-origin'), ORIGIN);

  const evil = await fetch(base + '/sync', {
    method: 'OPTIONS', headers: { Origin: 'https://evil.example' },
  });
  assert.equal(evil.headers.get('access-control-allow-origin'), null);
});

// One passphrase means brute force is the threat. Test the real limiter on its
// own app instance rather than trusting that it is wired up.
test('auth brute force is rate limited', { skip: !HAS_DB }, async () => {
  const app = createApp({ passphraseHash, allowedOrigins: [ORIGIN], authLimit: 3 });
  const s = app.listen(0);
  await new Promise((r) => s.once('listening', r));
  const url = `http://127.0.0.1:${s.address().port}/auth`;
  const guess = () => fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ passphrase: 'wrong' }),
  });
  try {
    assert.equal((await guess()).status, 401);
    assert.equal((await guess()).status, 401);
    assert.equal((await guess()).status, 401);
    const blocked = await guess();
    assert.equal(blocked.status, 429);
    assert.equal((await blocked.json()).error, 'too_many_attempts');

    // Crucially: the limit must hold even for the CORRECT passphrase, or it
    // would only be slowing down honest mistakes.
    const right = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ passphrase: PASSPHRASE }),
    });
    assert.equal(right.status, 429);
  } finally {
    await new Promise((r) => s.close(r));
  }
});

test('a request bigger than 1mb is refused as 413, not 500', { skip: !HAS_DB }, async () => {
  const token = await login();
  const huge = { since: 0, weeks: { '2026-07-13': week(1000, 'x'.repeat(1_200_000)) } };
  const r = await post('/sync', huge, token);
  assert.equal(r.status, 413);
  assert.equal((await r.json()).error, 'too_large');
  const { rows } = await pool.query('select count(*)::int as n from weeks');
  assert.equal(rows[0].n, 0);
});

/* ---------------- history: the thing that replaces manual backups ---------- */

const getJson = (path, token) =>
  fetch(base + path, { headers: { Authorization: `Bearer ${token}` } }).then((r) => r.json());

test('every changed version is recorded', { skip: !HAS_DB }, async () => {
  const token = await login();
  await post('/sync', { since: 0, weeks: { '2026-07-13': week(1000, 'v1') } }, token);
  await post('/sync', { since: 0, weeks: { '2026-07-13': week(2000, 'v2') } }, token);
  await post('/sync', { since: 0, weeks: { '2026-07-13': week(3000, 'v3') } }, token);

  const h = await getJson('/history?ref=2026-07-13', token);
  assert.equal(h.versions.length, 3);
  // newest first
  assert.deepEqual(h.versions.map((v) => v.updatedAt), [3000, 2000, 1000]);
});

test('an unchanged re-sync does not pile up identical versions', { skip: !HAS_DB }, async () => {
  const token = await login();
  await post('/sync', { since: 0, weeks: { '2026-07-13': week(1000, 'same') } }, token);
  // Same content, later timestamp — wins LWW, but there is nothing new to keep.
  await post('/sync', { since: 0, weeks: { '2026-07-13': week(2000, 'same') } }, token);
  await post('/sync', { since: 0, weeks: { '2026-07-13': week(3000, 'same') } }, token);

  const h = await getJson('/history?ref=2026-07-13', token);
  assert.equal(h.versions.length, 1, 'only the first version should be recorded');
});

/*
 * The test above passes with either implementation: its fixture's keys happen
 * to already be in jsonb's canonical order (by key length, then bytewise), so
 * JSON.stringify agreed by luck. A real week's keys do not, which is why the
 * guard never actually fired in production.
 */
test('an unchanged re-sync is unchanged whatever order the keys arrive in', { skip: !HAS_DB }, async () => {
  const token = await login();
  // The shape emptyWeek() really sends, in the order it really sends it.
  const real = (updatedAt) => ({
    focus: 'ship it', notes: 'n', priorities: [], todos: [],
    days: { mon: [], tue: [] }, habitChecks: {}, blocks: [], updatedAt,
  });
  // The same content, keys shuffled — as jsonb hands it back.
  const shuffled = (updatedAt) => ({
    days: { tue: [], mon: [] }, blocks: [], habitChecks: {}, todos: [],
    priorities: [], notes: 'n', focus: 'ship it', updatedAt,
  });

  await post('/sync', { since: 0, weeks: { '2026-07-13': real(1000) } }, token);
  await post('/sync', { since: 0, weeks: { '2026-07-13': shuffled(2000) } }, token);
  await post('/sync', { since: 0, weeks: { '2026-07-13': real(3000) } }, token);

  const h = await getJson('/history?ref=2026-07-13', token);
  assert.equal(h.versions.length, 1,
    'key order is not a content change: re-syncing the same week must not append a version');
});

test('stableStringify ignores key order but not content', { skip: !HAS_DB }, async () => {
  const { stableStringify } = await import('../index.js');
  assert.equal(stableStringify({ a: 1, b: 2 }), stableStringify({ b: 2, a: 1 }));
  assert.notEqual(stableStringify({ a: 1 }), stableStringify({ a: 2 }));
  // Nested, and arrays keep their order because in an array order IS content.
  assert.equal(stableStringify({ x: { p: 1, q: 2 } }), stableStringify({ x: { q: 2, p: 1 } }));
  assert.notEqual(stableStringify({ x: [1, 2] }), stableStringify({ x: [2, 1] }));
  assert.equal(stableStringify(null), 'null');
});

test('a losing write records nothing', { skip: !HAS_DB }, async () => {
  const token = await login();
  await post('/sync', { since: 0, weeks: { '2026-07-13': week(5000, 'winner') } }, token);
  await post('/sync', { since: 0, weeks: { '2026-07-13': week(4000, 'loser') } }, token);
  const h = await getJson('/history?ref=2026-07-13', token);
  assert.equal(h.versions.length, 1);
  assert.equal(h.versions[0].updatedAt, 5000);
});

/*
 * The cursor gap. seq is allocated by nextval() at write time, but the cursor
 * published to a device is max(seq) over COMMITTED rows — so without
 * serialisation a device can store a cursor that steps over a peer's row that
 * was still in flight, and `seq > cursor` then never returns it. The week is
 * not conflicted or delayed; it is silently gone from that device forever.
 *
 * Two devices, each pushing its own weeks and advancing its own cursor from the
 * response, exactly as the client does. Then each pulls with its stored cursor
 * and must have been told about every week the other wrote. Concurrency makes
 * this probabilistic: without the advisory lock it fails most runs, so the
 * rounds are here to make "most" into "effectively always".
 */
test('two devices syncing at once never lose a week to the cursor', { skip: !HAS_DB }, async () => {
  const token = await login();
  const ROUNDS = 12;

  // Each device tracks its own cursor from the server's reply, like the client.
  const devices = [
    { name: 'phone', cursor: 0, seen: new Set() },
    { name: 'ipad', cursor: 0, seen: new Set() },
  ];
  const written = new Set();

  const isoFor = (round, d) => {
    // Distinct real dates: phone takes even weeks, iPad odd.
    const day = 1 + (round * 2 + (d === 'phone' ? 0 : 1));
    return '2026-01-' + String(day).padStart(2, '0');
  };

  for (let round = 0; round < ROUNDS; round++) {
    await Promise.all(devices.map(async (dev) => {
      const iso = isoFor(round, dev.name);
      written.add(iso);
      const r = await post('/sync', {
        since: dev.cursor,
        weeks: { [iso]: week(1000 + round, dev.name + '-' + round) },
      }, token);
      const body = await r.json();
      assert.equal(r.status, 200);
      for (const k of Object.keys(body.weeks)) dev.seen.add(k);
      dev.cursor = body.now;          // exactly what SYNC.setCursor does
    }));
  }

  // Drain: each device syncs until it stops learning anything new, which is all
  // a real device ever gets to do.
  for (const dev of devices) {
    for (let i = 0; i < 3; i++) {
      const body = await (await post('/sync', { since: dev.cursor, weeks: {} }, token)).json();
      for (const k of Object.keys(body.weeks)) dev.seen.add(k);
      dev.cursor = body.now;
    }
  }

  for (const dev of devices) {
    const missing = [...written].filter((iso) => !dev.seen.has(iso)).sort();
    assert.deepEqual(missing, [],
      `${dev.name} was never sent these weeks and never will be: ${missing.join(', ')}`);
  }
});

test('an accidental delete can be undone', { skip: !HAS_DB }, async () => {
  const token = await login();
  // A week of real work...
  await post('/sync', {
    since: 0,
    weeks: { '2026-07-13': { focus: 'a month of planning', blocks: [{ text: 'Cafe shift' }], updatedAt: 1000 } },
  }, token);

  // ...then it is wiped, and the deletion syncs faithfully to every device.
  await post('/sync', {
    since: 0, weeks: { '2026-07-13': { focus: '', blocks: [], updatedAt: 2000, deleted: true } },
  }, token);

  const fresh = await getJson('/history?ref=2026-07-13', token);
  assert.equal(fresh.versions.length, 2);
  const good = fresh.versions.find((v) => v.updatedAt === 1000);

  const restored = await (await post('/restore', { id: good.id }, token)).json();
  assert.equal(restored.restored.ref, '2026-07-13');

  // A device that pulls from scratch now sees the work back, not the deletion.
  const down = await (await post('/sync', { since: 0 }, token)).json();
  assert.equal(down.weeks['2026-07-13'].focus, 'a month of planning');
  assert.equal(down.weeks['2026-07-13'].blocks[0].text, 'Cafe shift');
  assert.ok(!down.weeks['2026-07-13'].deleted, 'the tombstone must be lifted');
});

test('a restore wins on other devices, and is itself undoable', { skip: !HAS_DB }, async () => {
  const token = await login();
  await post('/sync', { since: 0, weeks: { '2026-07-13': week(1000, 'original') } }, token);
  await post('/sync', { since: 0, weeks: { '2026-07-13': week(2000, 'mistake') } }, token);

  const h = await getJson('/history?ref=2026-07-13', token);
  const original = h.versions.find((v) => v.updatedAt === 1000);
  const r = await (await post('/restore', { id: original.id }, token)).json();

  // Stamped now, so it beats the "mistake" on every device's next sync.
  assert.ok(r.restored.updatedAt > 2000);
  const down = await (await post('/sync', { since: 0 }, token)).json();
  assert.equal(down.weeks['2026-07-13'].focus, 'original');

  // The restore is recorded too, so restoring the wrong thing is recoverable.
  const after = await getJson('/history?ref=2026-07-13', token);
  assert.equal(after.versions.length, 3);
  assert.ok(after.versions.some((v) => v.updatedAt === 2000), 'the mistake is still there to go back to');
});

/*
 * The two ways the process used to die outright. Both matter more than they
 * look: a single-user service idles with connections open for hours, so a
 * Railway Postgres restart is the normal case, not an exotic one.
 */
test('an idle client error does not kill the process', { skip: !HAS_DB }, async () => {
  // pg re-emits a dropped idle client's error on the pool. An 'error' event
  // with no listener THROWS, from a socket callback no handler can catch —
  // which crash-looped the container. Emitting it here reproduces that exactly.
  assert.doesNotThrow(() => {
    pool.emit('error', Object.assign(new Error('connection terminated unexpectedly'), { code: 'ECONNRESET' }));
  });
  // ...and the service still works afterwards.
  const r = await fetch(base + '/health');
  assert.equal(r.status, 200);
});

/*
 * Express 4 ignores an async handler's returned promise, so a rejection from
 * handleSync's own `await pool.connect()` escaped as an unhandled rejection —
 * which Node 20 turns into a dead process. The same outage gave /health a tidy
 * 503, which is what made this worth fixing rather than shrugging at.
 *
 * Isolating it needs care: requireAuth runs first and needs the database too,
 * so simply breaking the pool 500s at auth and never reaches the code under
 * test. pool.query connects CALLBACK-style, while handleSync awaits the promise
 * form — so failing only the promise form leaves auth working and breaks
 * exactly the one call this is about. (The real-world shape of this is the pool
 * timing out under `max: 4` while auth already holds a connection.)
 */
test('a connect failure inside sync is a 500, not a dead process', { skip: !HAS_DB }, async () => {
  const token = await login();
  const realConnect = pool.connect.bind(pool);
  const unhandled = [];
  const onUnhandled = (e) => unhandled.push(e);
  process.on('unhandledRejection', onUnhandled);

  pool.connect = function (cb) {
    if (typeof cb === 'function') return realConnect(cb);   // auth's pool.query still works
    return Promise.reject(Object.assign(new Error('timeout exceeded when trying to connect'), { code: 'ETIMEDOUT' }));
  };
  try {
    // Without the fix the rejection escapes, Express 4 never answers, and this
    // request hangs forever — so cap it rather than let the suite time out.
    const r = await fetch(base + '/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ since: 0, weeks: { '2026-07-13': week(1000, 'x') } }),
      signal: AbortSignal.timeout(5000),
    }).catch((e) => {
      assert.fail('sync never answered (' + e.name + '): the rejection escaped the handler, ' +
        'which in production is an unhandled rejection and a dead process');
    });
    assert.equal(r.status, 500, 'the caller must be told, not left hanging');
    assert.equal((await r.json()).error, 'server_error');
    // The point of the fix: the rejection was caught rather than escaping.
    await new Promise((r2) => setImmediate(r2));
    assert.deepEqual(unhandled, [], 'an unhandled rejection here is what killed the process');
  } finally {
    pool.connect = realConnect;
    process.off('unhandledRejection', onUnhandled);
  }
  // Still standing and serving.
  assert.equal((await fetch(base + '/health')).status, 200);
});

test('a weeks array is refused, not waved through unvalidated', { skip: !HAS_DB }, async () => {
  const token = await login();
  // validateSync used to substitute {} for an array and report "valid", while
  // handleSync (typeof [] === 'object') went on to write it — so nothing about
  // this body was ever checked, and only the date cast stopped it, as a 500.
  const r = await post('/sync', {
    since: 0,
    weeks: [{ focus: 'x', updatedAt: 99999999999999 }],
  }, token);
  assert.equal(r.status, 400, 'a bad shape is the caller\'s fault, not a server error');
  assert.equal((await r.json()).error, 'bad_weeks');
});

test('a nonsense history limit is a 400-style answer, not a 500', { skip: !HAS_DB }, async () => {
  const token = await login();
  await post('/sync', { since: 0, weeks: { '2026-07-13': week(1000, 'v1') } }, token);
  for (const q of ['-1', '1.5', 'abc', '0']) {
    const r = await fetch(base + '/history?ref=2026-07-13&limit=' + q, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(r.status, 200, `limit=${q} must not reach Postgres verbatim and 500`);
  }
});

test('a restore still wins against a week stamped in the future', { skip: !HAS_DB }, async () => {
  const token = await login();
  // validateSync tolerates 5 minutes of clock skew, so a phone running fast can
  // leave a stored week stamped ahead of the server. Stamping the restore
  // `now` then loses the upsert's `updated_at >` test silently: the restore
  // does nothing and still answers 200.
  const future = Date.now() + 4 * 60 * 1000;
  await post('/sync', { since: 0, weeks: { '2026-07-13': week(1000, 'the good version') } }, token);
  const h = await getJson('/history?ref=2026-07-13', token);
  const good = h.versions[0];

  await post('/sync', { since: 0, weeks: { '2026-07-13': week(future, 'the mistake') } }, token);

  const r = await post('/restore', { id: good.id }, token);
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.ok(body.restored.updatedAt > future, 'a restore must be stamped to win, not merely to be now');

  // And it must actually be what devices now pull.
  const pulled = await (await post('/sync', { since: 0, weeks: {} }, token)).json();
  assert.equal(pulled.weeks['2026-07-13'].focus, 'the good version',
    'the restore reported success, so it must have actually happened');
});

test('history needs auth and rejects a nonsense ref', { skip: !HAS_DB }, async () => {
  assert.equal((await fetch(base + '/history?ref=2026-07-13')).status, 401);
  const token = await login();
  const bad = await fetch(base + '/history?ref=hello', { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(bad.status, 400);
  const missing = await post('/restore', { id: 999999 }, token);
  assert.equal(missing.status, 404);
});

test('settings changes are recorded too', { skip: !HAS_DB }, async () => {
  const token = await login();
  await post('/sync', { since: 0, settings: { habits: ['Water'], updatedAt: 1000 } }, token);
  await post('/sync', { since: 0, settings: { habits: [], updatedAt: 2000 } }, token);  // deleted every habit
  const h = await getJson('/history?ref=settings', token);
  assert.equal(h.versions.length, 2);

  const withHabits = h.versions.find((v) => v.updatedAt === 1000);
  await post('/restore', { id: withHabits.id }, token);
  const down = await (await post('/sync', { since: 0 }, token)).json();
  assert.deepEqual(down.settings.habits, ['Water']);
});

/* ---------------- boot diagnostics ----------------------------------------
   A real Railway crash-loop logged "[boot] migration failed:" with nothing
   after it, because the handler logged only e.message and the error was an
   AggregateError, whose message is empty by design. These pin the fix. */

test('describeError unpacks an AggregateError instead of printing nothing', { skip: !HAS_DB }, async () => {
  const { describeError } = await import('../index.js');
  // Exactly the shape Node produces when every address for a host is refused.
  const sub1 = Object.assign(new Error('connect ECONNREFUSED ::1:5432'), { code: 'ECONNREFUSED' });
  const sub2 = Object.assign(new Error('connect ECONNREFUSED 10.0.0.5:5432'), { code: 'ECONNREFUSED' });
  const agg = new AggregateError([sub1, sub2]);

  assert.equal(agg.message, '', 'precondition: AggregateError really does have an empty message');

  const text = describeError(agg);
  assert.ok(text.length > 0, 'must never render as an empty string');
  assert.match(text, /ECONNREFUSED ::1:5432/);
  assert.match(text, /ECONNREFUSED 10\.0\.0\.5:5432/);
});

test('describeError handles ordinary errors and junk', { skip: !HAS_DB }, async () => {
  const { describeError } = await import('../index.js');
  assert.match(describeError(Object.assign(new Error('nope'), { code: 'X' })), /nope.*code=X/);
  assert.ok(describeError(null).length > 0);
  assert.ok(describeError(new Error('')).length > 0, 'an empty Error must still say something');
});

test('dbTarget never leaks the database password', { skip: !HAS_DB }, async () => {
  const { dbTarget } = await import('../index.js');
  const out = dbTarget('postgresql://postgres:sup3rs3cret@postgres.railway.internal:5432/railway');
  assert.equal(out, 'postgres.railway.internal:5432/railway');
  assert.ok(!out.includes('sup3rs3cret'), 'the password must never reach a log');
  assert.ok(!out.includes('postgres:'), 'nor the user');
  // An unresolved Railway reference is a real mistake worth naming.
  assert.match(dbTarget('${{Postgres.DATABASE_URL}}'), /not a valid URL/);
});

test('malformed JSON is a 400, not a 500', { skip: !HAS_DB }, async () => {
  const token = await login();
  const r = await fetch(base + '/sync', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: '{ this is not json',
  });
  assert.equal(r.status, 400);
  assert.equal((await r.json()).error, 'bad_json');
});
