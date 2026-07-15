import pg from 'pg';

const { Pool } = pg;

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Railway's private network needs no TLS; an external URL does.
  ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : false,
  max: 4,
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
  `);
}

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
