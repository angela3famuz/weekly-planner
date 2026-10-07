# Weekly Planner

A single-file weekly planner: focus, priorities, to-dos, per-day tasks, a drag-and-drop
time-block schedule, and a habit tracker. No build step, no dependencies, no backend.

**Your data never leaves your device.** Everything is stored in the browser's
`localStorage`, keyed by week. Nothing is uploaded anywhere.

> **Back it up, and install it.** Because the data is only in `localStorage`, two things
> can lose it. iOS Safari deletes all script-writable storage after **7 days** without a
> visit — a real risk for a *weekly* planner. Home-screen installs are exempt from that,
> which is the main reason to install rather than use a tab. Either way, take a backup
> (**⋯ → Download backup**) and keep the file somewhere safe.

## Running it

Open `index.html` in a browser. That's it.

For the service worker (offline support) to register, the page needs a secure context —
so `https://` or `localhost`, not `file://`. Opening the file directly still works fine,
it just won't cache for offline use.

## Install to your home screen

Once the page is served over HTTPS:

- **iOS / Safari** — Share → *Add to Home Screen*. Opens fullscreen, no browser bar.
- **Android / Chrome** — menu → *Install app* / *Add to Home screen*.

This gives you an app-like icon, not a live widget: home-screen widgets are a native
OS feature and need a native app to supply them.

Note that an installed copy keeps its own `localStorage`, separate from the same page
open in a normal browser tab. Entries made in one won't appear in the other.

## Priorities, to-dos and carry-over

Add as many as you like — type and press the **+** button (or Enter). Tap the box to cycle
**done ✓ → missed ✕ → open**.

**Unfinished work follows you into the new week.** The first time you open the current week,
anything from the previous week that wasn't ticked off — open *or* missed — is copied
across, reset to open, and marked **↩**. Done items stay behind. So does anything you
deleted.

The details, because they're deliberate:

- It only ever happens **once per week**, and only for the **current** week. Past weeks are
  never rewritten — last week keeps its honest record of what was left open.
- Peeking at a future week doesn't carry anything into it. Next week gets its items when
  next week arrives.
- Skipped a week or two? It carries from the most recent week you actually used.
- Items already on this week with the same text aren't duplicated.

## Habits

Add as many as you like. Tap a cell to mark the day. **Renaming a habit keeps its history** —
habits have a stable id, so the name is just a label.

## The schedule

**Tap any block to edit it** — label, day, start/end (native time pickers), category by
name, status, delete. Same sheet at any block size. **+ Add a block** does the same for a
new one. Times that run past midnight are split into two blocks either side of 12am, and
told to you before you save.

Drag still works for quick nudges: drag a block to move it (touch uses the ✥ grip, since a
plain drag scrolls the page), drag the bottom handle to resize, tap the circle to cycle
done ✓ / missed ✕ / clear. Blocks under ~55 minutes are too short to host a grip or
handle without swallowing the block, so use the editor for those.

The **Categories** row colours your blocks. Start with three (rename any by typing over it),
and **+ Add category** makes more, each with its own colour. The selected category is the
one new blocks take.

## Importing your calendar

The **Import** button (the camera in the top bar) reads a week of meetings into the
schedule. Everything happens on your device — nothing is uploaded. Two ways in:

### From a calendar file (.ics)

The direct route, and the accurate one. In **desktop Outlook**: *File → Save Calendar*,
set the range to **this week** with **Full details**, and save the `.ics`. Load that file
in the modal. The planner parses it in the browser:

- **Recurring meetings are expanded** into their real instances for the week you're
  viewing (daily, weekly-by-weekday, monthly), honouring `EXDATE` exclusions and
  `UNTIL`/`COUNT` limits.
- **All-day banners** (holidays, "out of office" bars) are skipped — only timed meetings
  come through.
- Times are read as written; anything stamped UTC is converted to your local time.

It's an ordinary `.ics` file, so exports from Google Calendar, Apple Calendar, or any
other calendar work too — move to the week you want here first, since only that week is read.

### From a photo (via Claude)

Tucked under *Or import from a photo instead*, for when you only have a screenshot. The
planner never sees your photo:

1. *Copy prompt for Claude* — puts a ready-made prompt on your clipboard, including the
   expected JSON shape, the week you're filling in, and a grid-reading procedure.
2. Send that to Claude with a photo of your calendar.
3. Paste the reply back. Code fences, surrounding chat, curly quotes and trailing commas
   are all tolerated.

Either way: meetings running past midnight are split into two blocks either side of 12am
and flagged `OVERNIGHT`, and meetings already on your schedule are marked *already added*
and unticked by default. Tick what you want and add it.

## Sync across devices

Sync lives in **[Thread (v2)](v2/)**, the reworked planner in `v2/`. It's optional and off
until you turn it on; without it everything is local, offline, and nothing is uploaded.

It syncs through **one private GitHub gist** — no server to run or pay for. You paste a GitHub
token (classic, with only the `gist` scope) once per device, optionally set a passphrase that
encrypts your data so GitHub only ever holds ciphertext, and carry a short **sync code** to your
other devices. Full setup is in [`v2/README.md`](v2/README.md#sync-across-devices). After that it
syncs on its own — on opening the app, when you refocus it, when you come back online, and a
couple of seconds after you stop typing — plus a **Sync now** button and a quiet dot when
something is waiting to go up.

What to expect:

- **Your device is the source of truth.** The gist is a shared replica. Everything works offline;
  changes go up when you reconnect.
- **Merging is per item, not per week.** Each sync 3-way merges against the last-synced snapshot,
  so an add, a delete and an edit are told apart per meeting, per week and per habit — a meeting
  added on your phone and a transcript distilled on your laptop both survive. Editing the *same*
  item on two devices before they sync is the only conflict; this device wins and Thread tells
  you, rather than losing a change silently.
- **Nothing can be destroyed by a sync failure.** A wrong token, a wrong passphrase, GitHub being
  unreachable — all leave your local data untouched and the planner working.
- **GitHub keeps every version** of the gist, so an accidental delete is recoverable from its
  revision history — the bit that lets manual backups stop being your only safety net.

> An earlier design synced through a self-hosted server (Postgres on Railway) — see
> [`docs/sync-design.md`](docs/sync-design.md) and [`server/`](server/). It was built out but
> never deployed; the gist-based sync above replaced it, so no server is needed.

## Backup & restore

**⋯ → Download backup** writes a JSON file holding every week, your habits and your
categories. Inside an installed iOS web app it goes through the share sheet (*Save to
Files*), because `<a download>` is unreliable there; everywhere else it downloads directly.

Restoring takes a file or pasted text, tells you what's in it, then offers two choices:

- **Merge** — adds only weeks you don't already have. A week on this device always wins;
  nothing you have is overwritten. Habits are unioned.
- **Replace all** — the backup becomes the truth: a week it doesn't have is deleted, not
  merely skipped. Asks for confirmation.

**If you've turned on sync (in Thread), a Replace-all also reaches your other devices on the
next sync** — weeks the backup lacks are removed there too. That is the point of it, but it is
worth knowing before reaching for it. The current week is emptied rather than deleted, because
the app always needs one.

Either way, **Undo** appears straight afterwards and puts back exactly what was there —
on every synced device, by the same path the restore took. It survives a reload, but it is
one level: a second restore replaces it, so undo a mistake before doing anything else.

Use this to move to a new phone, to recover after a wipe, or to carry entries from a
Safari tab into the installed app (iOS keeps those two storage areas separate, so a
one-time export/import is the only bridge).

## Layout

| File | Purpose |
| --- | --- |
| `index.html` | The whole app — markup, styles, and logic. |
| `manifest.webmanifest` | Install metadata: name, colors, icons. |
| `sw.js` | Service worker. Network-first for the page, cache-first for icons. |
| `icons/` | Generated PNGs. iOS only accepts PNG for `apple-touch-icon`. |
| `tools/make-icons.js` | Regenerates `icons/` — dependency-free rasterizer. |
| `v2/` | Thread — the reworked planner, with gist-based cross-device sync. See [`v2/README.md`](v2/README.md). |
| `docs/sync-design.md` | Earlier server-based sync design. Superseded by the gist sync in `v2/`. |
| `server/` | The self-hosted sync server from that earlier design. Built but not deployed. |

## Regenerating the icons

The icons are committed, so you only need this if you change the artwork in
`tools/make-icons.js`:

```sh
node tools/make-icons.js icons
```

After changing any cached asset, bump `CACHE` in `sw.js` (e.g. `wp-v1` → `wp-v2`) so
existing installs pick the change up.
