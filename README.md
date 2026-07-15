# Weekly Planner

A single-file weekly planner: focus, priorities, to-dos, per-day tasks, a drag-and-drop
time-block schedule, and a habit tracker. No build step, no dependencies, no backend.

**Your data never leaves your device.** Everything is stored in the browser's
`localStorage`, keyed by week. Nothing is uploaded anywhere.

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

## Layout

| File | Purpose |
| --- | --- |
| `index.html` | The whole app — markup, styles, and logic. |
| `manifest.webmanifest` | Install metadata: name, colors, icons. |
| `sw.js` | Service worker. Network-first for the page, cache-first for icons. |
| `icons/` | Generated PNGs. iOS only accepts PNG for `apple-touch-icon`. |
| `tools/make-icons.js` | Regenerates `icons/` — dependency-free rasterizer. |

## Regenerating the icons

The icons are committed, so you only need this if you change the artwork in
`tools/make-icons.js`:

```sh
node tools/make-icons.js icons
```

After changing any cached asset, bump `CACHE` in `sw.js` (e.g. `wp-v1` → `wp-v2`) so
existing installs pick the change up.
