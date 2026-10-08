# Thread home-screen widget (iOS, via Scriptable)

A PWA can't supply a native iOS home-screen widget — but [Scriptable](https://scriptable.app)
can, and Thread can publish a small feed it reads. [`thread-widget.js`](thread-widget.js) shows
your upcoming meetings on the home screen.

## How it works

With sync on, turning on **Thread → Sync → "Publish a home-screen widget feed"** writes a second
file, `thread-widget.json`, into your sync gist: a compact list of the next ~3 days of meetings
(title, time, category colour, status). The Scriptable widget fetches just that file and renders it.

The feed is stored **unencrypted** in your (secret, token-gated) gist — that's the trade-off that
lets a widget read it without the slow passphrase key-derivation. The rest of your Thread data stays
encrypted. Turn the toggle off to stop publishing the feed (and remove it from the gist).

## Setup

1. **Thread:** Sync → turn on **Publish a home-screen widget feed**, let it sync once.
2. **Scriptable:** install from the App Store → **+** → paste in `thread-widget.js` → name it "Thread".
3. Fill the two constants at the top:
   - `GIST_ID` — your **Sync code** (Thread → Sync).
   - `TOKEN` — the same **GitHub token** Thread uses (classic, `gist` scope).
4. Tap ▶ to preview. Then on the home screen: long-press → add a **Scriptable** widget →
   long-press it → **Edit Widget** → Script = "Thread". Small / Medium / Large all work.

Tapping the widget opens Thread. iOS refreshes widgets on its own schedule (~15–60 min), so it
reflects your last sync, not live edits.

## Limitations

- Shows the next ~3 days only (that's all the feed carries, to stay small).
- Needs sync on and the feed toggle on.
- Not real-time; refresh cadence is controlled by iOS.
- A true always-live widget would need a native app (WidgetKit) wrapping Thread — much more work.
