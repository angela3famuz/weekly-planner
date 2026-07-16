import pg from 'pg';
import { describeError } from './errors.js';

const { Pool } = pg;

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Railway's private network needs no TLS; an external URL does.
  ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : false,
  max: 4,
  // Without this, connect() on an unreachable database waits forever and the
  // request hangs instead of failing. A sync is a background retry — it can
  // afford to lose and try again far better than it can afford to hang.
  connectionTimeoutMillis: 10_000,
});

/*
 * A single-user service idles with connections open for hours, so Postgres
 * going away (a Railway restart, an OOM) is the NORMAL failure, not an exotic
 * one. pg re-emits an idle client's error on the pool, and an 'error' event
 * with no listener THROWS — from a socket callback, where no try/catch in a
 * request handler can reach it. That killed the process and crash-looped it.
 * The pool discards the dead client on its own; this only has to not die.
 */
pool.on('error', (e) => {
  console.error('[pool] idle client error (connection dropped, pool will recover): ' + describeError(e));
});

// Idempotent: safe to run on every boot.
export async function migrate() {
  await pool.query(`
    create sequence if not exists sync_seq;

    create table if not exists weeks (
      week_iso   date primary key,
      doc        jsonb   not null,
      deleted    boolean not null default false,
      updated_at bigint  not null,
      seq        bigint  not null
    );
    create index if not exists weeks_seq_idx on weeks (seq);

    create table if not exists settings (
      id         int primary key default 1,
      doc        jsonb  not null,
      updated_at bigint not null,
      seq        bigint not null
    );

    create table if not exists tokens (
      token_hash text primary key,
      created_at timestamptz not null default now(),
      last_seen  timestamptz
    );

    -- Append-only. Never updated, never deleted by the app.
    -- Sync on its own is a replica, not an archive: last-write-wins means a
    -- delete is just another write that wins, and it propagates faithfully to
    -- every device. This table is what makes an accidental delete recoverable,
    -- and the reason manual backups stop being the only safety net.
    create table if not exists history (
      id          bigserial primary key,
      kind        text    not null,          -- 'week' | 'settings'
      ref         text    not null,          -- the week's date, or 'settings'
      doc         jsonb   not null,
      deleted     boolean not null default false,
      updated_at  bigint  not null,
      recorded_at timestamptz not null default now()
    );
    create index if not exists history_ref_idx on history (kind, ref, id desc);
  `);
}

// Recorded only for writes that actually won, and only when the content really
// changed — re-syncing an unchanged week must not pile up identical rows.
export const INSERT_HISTORY = `
  insert into history (kind, ref, doc, deleted, updated_at)
  values ($1, $2, $3, $4, $5)
`;

export const SELECT_PREV_WEEK_DOC = `select doc, deleted from weeks where week_iso = $1`;
export const SELECT_PREV_SETTINGS_DOC = `select doc from settings where id = 1`;

export const SELECT_WEEK_STAMP = `select updated_at from weeks where week_iso = $1`;
export const SELECT_SETTINGS_STAMP = `select updated_at from settings where id = 1`;

/*
 * Taken at the top of every transaction that writes AND publishes a cursor, so
 * those transactions run one at a time.
 *
 * The cursor handed to a device is max(seq) over COMMITTED rows, but seq is
 * allocated by nextval() at write time. Under READ COMMITTED those two orders
 * are not the same, so without this lock:
 *
 *   phone writes week A, gets seq=5, tx still open
 *   iPad  writes week B, gets seq=6, reads cursor -> A is invisible -> 6
 *   iPad  commits, stores cursor 6
 *   phone commits; week A (seq=5) becomes visible to everyone
 *   iPad  syncs with since=6 -> `seq > 6` never matches -> week A is NEVER sent
 *
 * The week is not conflicted or delayed, it is silently missing on that device
 * forever, unless it happens to be edited again and gets a fresh seq. Two
 * devices on sync timers overlap eventually, so this is a matter of time.
 *
 * Serialising is affordable precisely because this service has one user: the
 * lock is uncontended in the normal case, and the alternative (a snapshot-aware
 * cursor built on pg_snapshot_xmin) is a great deal of machinery for one phone
 * and one iPad. It is released automatically at commit or rollback.
 */
export const LOCK_SYNC = `select pg_advisory_xact_lock(8534127)`;

export const SELECT_HISTORY = `
  select id, updated_at, recorded_at, deleted
  from history
  where kind = $1 and ref = $2
  order by id desc
  limit $3
`;

export const SELECT_HISTORY_DOC = `select kind, ref, doc, deleted from history where id = $1`;

/*
 * Last-write-wins, decided by the database rather than by a read-then-write in
 * JS, so two devices syncing at once cannot interleave. rowCount === 0 means the
 * stored copy was newer or equal and the incoming one lost: a conflict.
 *
 * nextval() in VALUES is evaluated even when the conflict branch runs, so the
 * sequence gains gaps. That is fine — seq only ever needs to increase.
 */
export const UPSERT_WEEK = `
  insert into weeks (week_iso, doc, deleted, updated_at, seq)
  values ($1, $2, $3, $4, nextval('sync_seq'))
  on conflict (week_iso) do update
    set doc = excluded.doc,
        deleted = excluded.deleted,
        updated_at = excluded.updated_at,
        seq = nextval('sync_seq')
    where excluded.updated_at > weeks.updated_at
  returning week_iso
`;

export const UPSERT_SETTINGS = `
  insert into settings (id, doc, updated_at, seq)
  values (1, $1, $2, nextval('sync_seq'))
  on conflict (id) do update
    set doc = excluded.doc,
        updated_at = excluded.updated_at,
        seq = nextval('sync_seq')
    where excluded.updated_at > settings.updated_at
  returning id
`;

// to_char keeps this a plain string end to end: a `date` handed to node-postgres
// comes back as a JS Date and would shift across timezones.
export const SELECT_CHANGED_WEEKS = `
  select to_char(week_iso, 'YYYY-MM-DD') as week_iso, doc, deleted
  from weeks
  where seq > $1
  order by seq
`;

export const SELECT_CHANGED_SETTINGS = `select doc from settings where seq > $1`;

export const SELECT_CURSOR = `
  select coalesce(greatest(
    (select max(seq) from weeks),
    (select max(seq) from settings)
  ), 0)::bigint as cursor
`;
