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

## Importing shifts from a photo

The planner never sees your photo. **Import shifts** walks you through a round trip:

1. *Copy prompt for Claude* — puts a ready-made prompt on your clipboard, including
   the expected JSON shape and today's date (so weekday names resolve to real dates).
2. Send that to Claude along with a photo of your schedule.
3. Paste the reply back. Code fences, surrounding chat, curly quotes and trailing
   commas are all tolerated — paste the whole reply if you like.
4. Tick the shifts you want and add them.

Shifts running past midnight are split into two blocks, one either side of 12am, and
flagged `OVERNIGHT` in the preview. Shifts already on your schedule are marked
*already added* and unticked by default.

## Sync across devices

Optional, and off until you turn it on. Without it the planner is exactly what it was:
local, offline, nothing uploaded.

**⋯ → Sync across devices** — paste your server address and passphrase, once per device.
After that it syncs on its own: on opening the app, when you come back to it, when you come
back online, and a second or so after you stop typing. There's a **Sync now** button if you
want to force it, and a quiet dot on the **⋯** button when something is waiting to upload.

Deploying the server is a separate job — see [`server/README.md`](server/README.md).

What to expect:

- **Your device is the source of truth.** The server is a replica. Everything works offline;
  changes queue and go up when you reconnect.
- **The whole week is the unit.** Editing the *same week* on two devices means the later edit
  wins and the other device's changes to that week are lost. For one person with two devices
  that's rarely reachable — but it's real, and the planner tells you when it happens rather
  than hiding it. See [`docs/sync-design.md`](docs/sync-design.md) §7.
- **Nothing can be destroyed by a sync failure.** A wrong passphrase, a dead token, a server
  that's down — all leave your local data untouched and the planner working.
- **The server keeps every version**, so an accidental delete is recoverable — which is the
  bit that lets manual backups stop being your safety net.

## Backup & restore

**⋯ → Download backup** writes a JSON file holding every week, your habits and your
categories. Inside an installed iOS web app it goes through the share sheet (*Save to
Files*), because `<a download>` is unreliable there; everywhere else it downloads directly.

Restoring takes a file or pasted text, tells you what's in it, then offers two choices:

- **Merge** — adds only weeks you don't already have. A week on this device always wins;
  nothing you have is overwritten. Habits are unioned.
- **Replace all** — wipes every week here first, then restores. Asks for confirmation.

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
| `docs/sync-design.md` | Proposal for cross-device sync. Nothing built yet. |

## Regenerating the icons

The icons are committed, so you only need this if you change the artwork in
`tools/make-icons.js`:

```sh
node tools/make-icons.js icons
```

After changing any cached asset, bump `CACHE` in `sw.js` (e.g. `wp-v1` → `wp-v2`) so
existing installs pick the change up.
