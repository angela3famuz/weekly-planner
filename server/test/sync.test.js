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
  // Raise the auth limit for the bulk of the suite; a dedicated test below
  // spins up its own app to check the real limiter actually bites.
  const app = createApp({ passphraseHash, allowedOrigins: [ORIGIN], authLimit: 1000, authGlobalLimit: 1000 });
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

test('health reports configured', { skip: !HAS_DB }, async () => {
  const r = await fetch(base + '/health');
  assert.deepEqual(await r.json(), { ok: true, configured: true });
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

test('a losing write records nothing', { skip: !HAS_DB }, async () => {
  const token = await login();
  await post('/sync', { since: 0, weeks: { '2026-07-13': week(5000, 'winner') } }, token);
  await post('/sync', { since: 0, weeks: { '2026-07-13': week(4000, 'loser') } }, token);
  const h = await getJson('/history?ref=2026-07-13', token);
  assert.equal(h.versions.length, 1);
  assert.equal(h.versions[0].updatedAt, 5000);
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
