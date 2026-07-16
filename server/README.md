# Weekly Planner — sync service

A deliberately small service so the planner can be edited on a phone and a laptop. One
passphrase, no accounts, no signup. See [`../docs/sync-design.md`](../docs/sync-design.md)
for why it works the way it does — particularly §7, which spells out what the simple
conflict model costs.

**Phase 2a: the service only.** The planner does not call it yet.

## Endpoints

| | |
| --- | --- |
| `GET /health` | `{ ok, configured }`. `configured:false` means `PASSPHRASE_HASH` is unset. |
| `POST /auth` | `{ passphrase }` → `{ token }`. Rate limited to 5 per IP per 15 min, and 20 globally. |
| `POST /sync` | `{ since, weeks, settings }` → `{ now, weeks, settings, conflicts }`. Bearer token. |
| `GET /history?ref=2026-07-13` | Versions available to restore, newest first. `ref=settings` for habits/categories. |
| `POST /restore` | `{ id }` from `/history`. Writes that version back as the current one. |
| `DELETE /tokens` | Signs out every device. Bearer token. |

## History — why sync alone is not a backup

Sync is a *replica*, not an *archive*. Last-write-wins means a deletion is just another
write that wins, and it propagates faithfully to every device. Without history, "I deleted
a month of planning" is unrecoverable no matter how many devices are in sync.

Every write that both **wins** and **changes something** is appended to `history`, which is
never updated and never deleted by the app. Unchanged re-syncs are not recorded, so idle
syncing does not pile up identical rows.

Restoring rewrites nothing: it writes the old content back as a **new current version
stamped now**, so it wins last-write-wins and reaches every device on its next sync. The
restore is itself recorded — restoring the wrong thing is also undoable.

```sh
curl -H "Authorization: Bearer $TOKEN" \
  "https://<service>.up.railway.app/history?ref=2026-07-13"

curl -X POST -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"id":42}' "https://<service>.up.railway.app/restore"
```

Growth is small — a year of ordinary use is well under a megabyte — but unbounded by
design. If it ever needs trimming, delete old rows by `recorded_at`; nothing depends on
them being present.

## Set your passphrase

```sh
node tools/hash-passphrase.js
```

**Nothing needs installing first.** The tool imports `kdf.js`, which is `node:crypto` and
nothing else, precisely because this is the first thing anyone runs.

It asks twice, echoes nothing, and prints a single `PASSPHRASE_HASH=…` line. **Your
passphrase is never written to disk, printed, or sent anywhere** — only the hash is, and a
hash cannot be reversed. Paste that line into Railway and keep the passphrase in your
password manager: it cannot be recovered, and you need it on every device.

Use a passphrase, not a PIN. It is the only thing between the internet and your schedule.

### On Windows, if `npm` will not run

```
npm : File C:\Program Files\nodejs\npm.ps1 cannot be loaded because running
scripts is disabled on this system.
```

PowerShell's execution policy blocks npm's `.ps1` wrapper. Nothing to do with this project.
Either use **`npm.cmd`** instead of `npm` (`npm.cmd install`), which skips the wrapper, or
allow local scripts once — this changes a security setting, so run it yourself and only if
you are comfortable with it:

```powershell
Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
```

`npm.cmd` is the smaller hammer. Either way, the hash step above needs neither.

## Run it locally

```sh
createdb planner_sync
cp .env.example .env          # then paste your PASSPHRASE_HASH into it
npm start                     # http://localhost:8080/health
```

Tables are created on boot; migration is idempotent.

## Tests

Needs a real Postgres — they exercise the actual conflict SQL, so an in-memory fake would
prove nothing.

```sh
createdb planner_sync_test
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/planner_sync_test npm test
```

Without `DATABASE_URL` they skip rather than fail.

## Deploying to Railway

These are the traps The Village hit on the same platform. They cost hours the first time.

1. **Service Root Directory must be `server`.** Otherwise Railway builds the repo root,
   finds no `package.json`, and fails confusingly.
2. **Add a PostgreSQL plugin to the project.** There is no `DATABASE_URL` without one, and
   the service exits at boot saying so.
3. **Generate a domain AND set its target port to match.** The app listens on `PORT` (8080
   by default). A mismatch gives `502 Application failed to respond` with nothing useful in
   the logs.
4. **Set `ALLOWED_ORIGINS`.** Unset means *no* browser can call the API — deliberately, so
   that forgetting it fails closed rather than allowing everything. This is the opposite of
   The Village's original behaviour, which reflected all origins until it was locked down.
5. **Set `PASSPHRASE_HASH`.** Without it `/auth` returns 503 and `/health` reports
   `configured:false`. Check that first if sync will not connect.

Verify with:

```sh
curl https://<your-service>.up.railway.app/health
# {"ok":true,"configured":true,"version":"a1b2c3d","database":"connected"}
```

| Field | Means |
| --- | --- |
| `database: "connected"` | It really queried Postgres — not just "the process is alive" |
| `configured: true` | `PASSPHRASE_HASH` is set; without it `/auth` returns 503 |
| `version` | The deployed commit, so you can tell whether a fix is actually live |

A `503` with `database: "unreachable"` means Postgres has gone away since boot. The reason is
in the service logs, not in the reply — it names the host and schema, so it is not for
whoever curls this.

**On the Railway canvas:** the arrow between your service and Postgres only appears if you
used a **variable reference** (`DATABASE_URL = ${{Postgres.DATABASE_URL}}`). Pasting the
connection string literally works but draws no arrow — and then the value is frozen, so it
silently breaks if Railway ever rotates the credentials. The reference is worth preferring
for that reason, not for the arrow.

### If it crash-loops on boot

The logs name the target and the real cause:

```
[config] database target: postgres.railway.internal:5432/railway
[boot] attempt 1/7 — cannot reach postgres.railway.internal:5432/railway: code=ECONNREFUSED · caused by: ...
```

Boot retries 7 times with backoff (~15s total) before giving up, because Railway's private
network takes a few seconds to come up and the first attempt legitimately fails. If it
still gives up:

| The target shown is | Meaning |
| --- | --- |
| `(not a valid URL …)` | `DATABASE_URL` was typed by hand and the `${{Postgres.DATABASE_URL}}` reference never resolved |
| `postgres.railway.internal` + `ENOTFOUND`/`ECONNREFUSED` | The Postgres plugin is not in the **same project** as this service — private hostnames do not cross projects |
| a public host + a TLS error | Set `DATABASE_SSL=true`; the private network needs no TLS but a public URL does |

## Notes

- `scrypt` comes from Node core, so there is no native module to build and one less
  dependency handling the one secret that matters.
- Tokens are 256-bit random and stored as SHA-256 hashes, so a database leak does not hand
  over a live session. They do not expire; `DELETE /tokens` is the revocation path.
- Rate limiting is in-process. It assumes **one instance** — correct for one user, but it
  would need a shared store if this ever scaled out.
- The service never logs request bodies. The schedule is personal data: where someone
  works, and when they are not home.
