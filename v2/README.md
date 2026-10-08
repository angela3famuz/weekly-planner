# Thread (v2)

A present-tense planner. Meetings are *threads*: distil a meeting's transcript and the next
one in the series opens knowing where you left off. Plus a weekly cockpit (focus, priorities,
to-dos, habits, notes), a drag-free schedule grid, `.ics` import, meeting nudges, and
backup/restore.

Single file (`index.html`), no build step, no backend. Everything lives in the browser's
`localStorage`. Install it to the home screen (iOS Safari: Share → *Add to Home Screen*) so
iOS doesn't evict the data after 7 days.

## Sync across devices

Optional, and off until you turn it on. Without it, Thread is exactly what it was: local,
offline, nothing uploaded.

It syncs through **one private GitHub gist** — there's no server to run or pay for, and GitHub
keeps every version of the gist, so an accidental delete is recoverable. Your device stays the
source of truth; everything works offline and reconciles when you're back online.

### Turning it on

1. On **github.com → Settings → Developer settings → Personal access tokens → Tokens
   (classic)**, generate a token with **only the `gist` scope** ticked. That token can read and
   write your gists and nothing else — it can't touch your repositories.
2. In Thread, footer → **Sync**. Paste the token. Optionally set a **passphrase** — if you do,
   your data is encrypted on this device (AES-GCM) before it's uploaded, so GitHub only ever
   holds ciphertext. Leave the **Sync code** blank on this first device.
3. **Turn on sync.** Thread creates the private gist and shows you a **Sync code** (the gist id).

On your **other devices**: open Sync, paste a token, the **same passphrase**, and that **Sync
code**, then Turn on sync. They converge.

After that it syncs on its own — on opening the app, when you refocus the tab, when you come
back online, and a couple of seconds after you stop typing — plus a **Sync now** button. A small
dot on the **Sync** link means something's waiting to go up (or the last sync failed; open the
sheet to see why).

### How merging works

Each sync reads the gist, merges it against the last-synced snapshot, writes the result back,
and remembers the new snapshot. Because that snapshot records what both devices last agreed on,
Thread can tell an **add** from a **delete** from an **edit** per item — per meeting, per week,
per habit:

- Add a meeting on your phone and distil a transcript on your laptop while offline → both land.
- Delete something on one device → it goes away on the others.
- The only real conflict is editing **the same item** on two devices before they sync. That's
  rare for one person; when it happens, **this device's copy wins and Thread tells you** rather
  than losing a change silently.

### Notes

- The token and passphrase are stored only on each device's `localStorage`, alongside the data
  they protect. Encryption's job is to keep the *gist copy* unreadable to GitHub.
- **Disconnect** (in the Sync sheet) stops syncing on that device and forgets its token; it
  leaves the gist on GitHub alone. Delete the gist on github.com if you want it gone everywhere.
- The whole state is small (hundreds of KB), so it fits comfortably in one gist file.

## Home-screen widget (iOS)

A PWA can't supply a native iOS home-screen widget, but [Scriptable](https://scriptable.app)
can — and Thread can hand it the data. With sync on, **Sync → "Publish a home-screen widget
feed"** writes a small `thread-widget.json` into your gist (the next ~3 days of meetings — title,
time, category colour, status), and the Scriptable widget in [`widget/`](widget/) reads just that
file to show your upcoming meetings on the home screen (tappable to open Thread).

The feed is stored **unencrypted** in your (secret, token-gated) gist — that's the trade-off that
lets a widget read it without the slow passphrase key-derivation; the rest of your data stays
encrypted, and turning the toggle off removes the feed. Full setup is in
[`widget/README.md`](widget/README.md). iOS controls the refresh cadence (~15–60 min), so the
widget reflects your last sync, not live edits. A truly always-live widget would need a native
WidgetKit app wrapping Thread.

## Files

| File | Purpose |
| --- | --- |
| `index.html` | The whole app. |
| `manifest.webmanifest` | Install metadata. |
| `sw.js` | Service worker (offline shell). Bump `CACHE` after changing a cached asset. |
| `icons/` | Generated PNG icons. |
| `widget/` | Scriptable home-screen widget (`thread-widget.js`) and its setup guide. |
